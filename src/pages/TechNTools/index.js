import React from 'react';
import PropTypes from 'prop-types';
import classNames from 'classnames';
import styled from 'styled-components';
import { withStyles } from 'material-ui/styles/index';
import GridList, { GridListTile, GridListTileBar } from 'material-ui/GridList';
import Typography from 'material-ui/Typography';
import IconButton from 'material-ui/IconButton';
import InformationIcon from 'mdi-react/InformationIcon';
import StarIcon from 'mdi-react/StarIcon';

import AppLayout from '../../layout/App';
import ContentLayout from '../../layout/Content';
import Header from '../../presentational/Header';
import Footer from '../../presentational/Footer';


const styles = theme => ({
  root: {
    padding: '20px',
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-evenly',
    backgroundColor: 'rgba(255, 255, 255, 0.6)',
  },
  gridList: {
    margin: '0 auto',
    alignContent: 'flex-start',
    flexDirection: 'column',
    '@media (min-width: 768px)': {
      flexDirection: 'row',
      width: '18vw',
      margin: 'unset',
    },
  },
  detailRoot: {
    margin: '0 auto',
    '@media (min-width: 768px)': {
      margin: 'unset',
    },
  },
  detailTile: {
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
  },
  iconImage: {
    display: 'block',
    width: '90%',
    height: 'auto',
    maxWidth: '100%',
    maxHeight: '100%',
    paddingTop: '10px',
    paddingBottom: '10px',
  },
});

//  Languages/Frameworks, Databases, BI Tools, Dev Tools/Platforms, Web Tools, Statistics

const data = [
  {
    name: 'Languages/Frameworks',
    children: [
      { name: 'Javascript', icon: '/statics/languages/javascript.png', stars: 4 },
      { name: 'HTML', icon: '/statics/languages/html.png', stars: 4 },
      { name: 'CSS', icon: '/statics/languages/css.png', stars: 3 },
      { name: 'R', icon: '/statics/languages/r.png', stars: 5 },
      { name: 'SQL', icon: '/statics/languages/sql.jpg', stars: 5 },
      { name: 'PL/SQL', icon: '/statics/languages/plsql.png', stars: 4 },
      { name: 'SAS', icon: '/statics/languages/sas.png', stars: 3 },
      { name: 'Shell', icon: '/statics/languages/shell.png', stars: 2 },
      { name: 'Python', icon: '/statics/languages/python.png', stars: 4 },
      { name: 'React', icon: '/statics/languages/react.png', stars: 4 },
      { name: 'Django', icon: '/statics/languages/django.png', stars: 5 },
    ],
  },
  {
    name: 'Databases',
    children: [
      { name: 'PostgreSQL', icon: '/statics/databases/postgresql.png', stars: 4 },
      { name: 'Oracle', icon: '/statics/databases/oracle.png', stars: 4 },
      { name: 'Amazon Redshift', icon: '/statics/databases/redshift.png', stars: 5 },
      { name: 'Teradata', icon: '/statics/databases/teradata.png', stars: 4 },
      { name: 'MongoDB', icon: '/statics/databases/mongodb.png', stars: 3 },
      { name: 'MySQL', icon: '/statics/databases/mysql.png', stars: 3 },
    ],
  },
  {
    name: 'BI Tools',
    children: [
      { name: 'Tableau', icon: '/statics/bi_tools/tableau.png', stars: 4 },
      { name: 'ODI', icon: '/statics/bi_tools/odi.jpg', stars: 5 },
      { name: 'Pentaho', icon: '/statics/bi_tools/pentaho.png', stars: 5 },
      { name: 'Power BI', icon: '/statics/bi_tools/power_bi.png', stars: 4 },
      { name: 'AWS Batch', icon: '/statics/bi_tools/aws_batch.png', stars: 3 },
      { name: 'Qlikview', icon: '/statics/bi_tools/qlikview.png', stars: 2 },
    ],
  },
  {
    name: 'Dev Tools/Platforms',
    children: [
      { name: 'AWS', icon: '/statics/dev/aws.png', stars: 4 },
      { name: 'Heroku', icon: '/statics/dev/heroku.png', stars: 3 },
      { name: 'Github', icon: '/statics/dev/github.png', stars: 4 },
    ],
  },
  {
    name: 'Web Tools/Platforms',
    children: [
      { name: 'Google Analytics', icon: '/statics/web/google_analytics.png', stars: 5 },
      { name: 'Facebook Analytics', icon: '/statics/web/facebook.jpg', stars: 4 },
      { name: 'Wordpress', icon: '/statics/web/wordpress.png', stars: 5 },
      { name: 'WooCommerce', icon: '/statics/web/woocommerce.png', stars: 4 },
      { name: 'Mautic', icon: '/statics/web/mautic.png', stars: 3 },
      { name: 'Intercom', icon: '/statics/web/intercom.png', stars: 4 },
    ],
  },
];


const TechNTools = ({ classes }) => (
  <AppLayout>
    <Header />
    <ContentLayout>
      <div className={classes.root}>
        {data.map(category => (
          <GridList cellHeight={180} className={classes.gridList}>
            <GridListTile key="Subheader" cols={2} style={{ height: '50px' }}>
              <Typography variant="title" className={classes.categoryName}>{category.name}</Typography>
            </GridListTile>
            {category.children.map(detail => (
              <GridListTile key={detail.name} classes={{ root: classes.detailRoot, tile: classes.detailTile }}>
                <img src={detail.icon} alt={detail.name} className={classes.iconImage} />
                <GridListTileBar
                  title={detail.name}
                  subtitle={<span>{Array(detail.stars).fill(<StarIcon size={11} color="rgba(255, 255, 255 ,0.8)" />)}</span>}
                  actionIcon={
                    <IconButton>
                      <InformationIcon color="rgba(255, 255, 255 ,0.2)" size={25} />
                    </IconButton>
                  }
                />
              </GridListTile>
            ))}
          </GridList>
        ))}
      </div>
    </ContentLayout>
    <Footer />
  </AppLayout>
);

TechNTools.propTypes = {
  classes: PropTypes.object.isRequired,
};

export default withStyles(styles)(TechNTools);
